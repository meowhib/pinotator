import type { GetDiscovery, ManagerContext } from './types.js';
import { randomUUID } from 'node:crypto';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import YAML from 'yaml';
import {
  createZip,
  inspectZip,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_FILES,
  MAX_ARCHIVE_FILE_BYTES,
} from './archives.js';
import { z } from 'zod';

const inspectRequest = z
  .object({
    archiveBase64: z.string().max(7_100_000),
    filename: z.string().max(120),
    confirmed: z.literal(true),
  })
  .strict();
const proposeRequest = z
  .object({
    importId: z.string().uuid(),
    scope: z.enum(['global', 'project', 'portable', 'portable-project']),
    confirmScripts: z.boolean().optional(),
    confirmed: z.literal(true),
  })
  .strict();
const exportRequest = z
  .object({
    resourceId: z.string().uuid(),
    confirmScripts: z.boolean().optional(),
    confirmed: z.literal(true),
  })
  .strict();
const pendingImports = new Map();
const EXTERNAL_SCRIPTS = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1|bat|cmd)$/i;
function error(code, message, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, details });
}
function scriptLike(entry) {
  return (
    entry.executable ||
    EXTERNAL_SCRIPTS.test(entry.path) ||
    entry.data.subarray(0, 2).toString() === '#!'
  );
}
function parseSkillName(content) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match)
    throw error(
      'SKILL_FRONTMATTER_REQUIRED',
      'The archive needs a SKILL.md with YAML frontmatter.',
      422,
    );
  let metadata;
  try {
    metadata = YAML.parse(match[1]);
  } catch {
    throw error('SKILL_FRONTMATTER_INVALID', 'SKILL.md frontmatter is invalid YAML.', 422);
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name || '') ||
    metadata.name.length > 64 ||
    typeof metadata.description !== 'string' ||
    !metadata.description.trim() ||
    metadata.description.length > 1024
  )
    throw error(
      'SKILL_METADATA_INVALID',
      'Skill name and description do not satisfy Pi portable skill rules.',
      422,
    );
  return metadata.name;
}
function noSecrets(entries) {
  for (const entry of entries) {
    const content = entry.data.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(entry.data))
      throw error(
        'BINARY_SKILL_ASSET',
        `Binary assets are currently unsupported: ${entry.path}`,
        422,
      );
    if (
      /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@[^\s]+|[?&](?:api[_-]?key|token|secret|password)=/i.test(
        content,
      ) ||
      /(?:api[_-]?key|secret|token|password|authorization|credential|private[_-]?key|client[_-]?secret)\s*[:=]\s*(?:\"[^\"]+\"|'[^']+'|[^\s,#}]+)/i.test(
        content,
      )
    )
      throw error(
        'SECRET_BEARING_CONTENT',
        `Credential-like content was found in ${entry.path}; import is blocked.`,
        422,
      );
  }
}
function extractSkill(entries) {
  const skills = entries.filter((entry) => basename(entry.path) === 'SKILL.md');
  if (skills.length !== 1)
    throw error('SKILL_ARCHIVE_INVALID', 'Archive must contain exactly one SKILL.md.', 422);
  const root = dirname(skills[0].path) === '.' ? '' : `${dirname(skills[0].path)}/`;
  if (entries.some((entry) => !entry.path.startsWith(root)))
    throw error(
      'SKILL_ARCHIVE_INVALID',
      'Archive must contain one skill folder and no unrelated files.',
      422,
    );
  const files = entries
    .map((entry) => ({ ...entry, path: entry.path.slice(root.length) }))
    .filter((entry) => entry.path);
  if (files.length > 50 || files.some((entry) => entry.data.length > MAX_ARCHIVE_FILE_BYTES))
    throw error('ARCHIVE_LIMIT', 'Skill exceeds the import file count or size limit.', 413);
  const manifest = files.find((entry) => entry.path === 'SKILL.md');
  const name = parseSkillName(manifest.data.toString('utf8'));
  noSecrets(files);
  return { name, files };
}
async function scanSkillDirectory(directory) {
  const files = [];
  let total = 0;
  const rootInfo = await lstat(directory).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
    throw error('SKILL_SOURCE_UNSAFE', 'Skill directory is missing or a symlink.', 403);
  async function walk(dir, depth) {
    if (depth > 8 || files.length >= MAX_ARCHIVE_FILES)
      throw error('ARCHIVE_LIMIT', 'Skill directory exceeds export bounds.', 413);
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = join(dir, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw error(
          'SKILL_SYMLINK_REJECTED',
          `Skill contains a symlink: ${relative(directory, path)}`,
          422,
        );
      if (child.name.startsWith('.'))
        throw error(
          'SKILL_FILE_UNSUPPORTED',
          `Hidden skill paths are not exported: ${relative(directory, path)}`,
          422,
        );
      if (info.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!info.isFile() || info.size > MAX_ARCHIVE_FILE_BYTES)
        throw error(
          'SKILL_FILE_UNSUPPORTED',
          `Unsupported or oversized skill file: ${relative(directory, path)}`,
          422,
        );
      const data = await readFile(path);
      total += data.length;
      if (total > MAX_ARCHIVE_BYTES)
        throw error('ARCHIVE_LIMIT', 'Skill export exceeds the archive size bound.', 413);
      const entry = {
        path: relative(directory, path).split(/[\\/]/).join('/'),
        data,
        mode: info.mode & 0o777,
        executable: Boolean(info.mode & 0o111),
      };
      files.push(entry);
    }
  }
  await walk(directory, 0);
  if (!files.some((entry) => entry.path === 'SKILL.md'))
    throw error('SKILL_SOURCE_INVALID', 'Skill folder no longer contains SKILL.md.', 409);
  return files;
}
export function createSkillTransferService({
  getDiscovery,
  context,
  propose,
}: {
  getDiscovery: GetDiscovery;
  context: ManagerContext;
  propose: (payload: unknown) => Promise<any>;
}) {
  function prune() {
    const now = Date.now();
    for (const [id, item] of pendingImports) if (item.expiresAt < now) pendingImports.delete(id);
    while (pendingImports.size > 10) pendingImports.delete(pendingImports.keys().next().value);
  }
  return {
    async inspectImport(payload) {
      const request = inspectRequest.parse(payload);
      prune();
      if (!/^[a-zA-Z0-9._ -]{1,120}$/.test(request.filename))
        throw error('INVALID_ARCHIVE_NAME', 'Upload filename is invalid.');
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          request.archiveBase64,
        )
      )
        throw error('ARCHIVE_INVALID', 'Upload is not valid base64.');
      const archive = Buffer.from(request.archiveBase64, 'base64');
      if (archive.length > MAX_ARCHIVE_BYTES)
        throw error('ARCHIVE_LIMIT', 'Archive exceeds the 5 MiB upload limit.', 413);
      const skill = extractSkill(inspectZip(archive));
      const id = randomUUID();
      const scripts = skill.files.filter(scriptLike).map((entry) => entry.path);
      pendingImports.set(id, {
        ...skill,
        filename: request.filename,
        scripts,
        expiresAt: Date.now() + 10 * 60_000,
      });
      return {
        importId: id,
        name: skill.name,
        filename: request.filename,
        expiresInSeconds: 600,
        files: skill.files.map((entry) => ({
          path: entry.path,
          size: entry.data.length,
          scriptLike: scriptLike(entry),
        })),
        scripts,
        modePolicy:
          'Imported files are created as private non-executable files; archive executable bits are not preserved.',
      };
    },
    async proposeImport(payload) {
      const request = proposeRequest.parse(payload);
      prune();
      const skill = pendingImports.get(request.importId);
      if (!skill)
        throw error('IMPORT_EXPIRED', 'Import inspection expired; inspect the archive again.', 410);
      if (
        skill.name !==
        parseSkillName(skill.files.find((entry) => entry.path === 'SKILL.md').data.toString('utf8'))
      )
        throw error(
          'SKILL_METADATA_CHANGED',
          'Import metadata changed; inspect the archive again.',
          409,
        );
      if (skill.scripts.length && !request.confirmScripts)
        throw error(
          'SCRIPT_REVIEW_REQUIRED',
          'Archive contains executable or script-like files. Confirm that their contents were inspected; none will be run.',
          422,
          { scripts: skill.scripts },
        );
      if (request.scope === 'global' && !context.agentDirectory)
        throw error('INVALID_SCOPE', 'Global skills are unavailable.');
      const edits = skill.files.map((entry) => {
        const text = entry.data.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(entry.data))
          throw error(
            'BINARY_SKILL_ASSET',
            `Binary assets are currently unsupported: ${entry.path}`,
            422,
          );
        return {
          intent: 'create',
          createTarget: {
            scope: request.scope,
            kind: 'skill-import-file',
            basename: `${skill.name}/${entry.path}`,
          },
          content: text,
        };
      });
      const result = await propose({ edits });
      pendingImports.delete(request.importId);
      return {
        ...result,
        importedSkill: skill.name,
        fileCount: edits.length,
        scriptsCleared: skill.scripts.length > 0,
      };
    },
    async exportSkill(payload) {
      const request = exportRequest.parse(payload);
      const discovery = await getDiscovery();
      const resource = discovery.getResource(request.resourceId);
      if (!resource || resource.kind !== 'skill' || !resource.source?.fileId)
        throw error(
          'SOURCE_NOT_FOUND',
          'Selected skill was not found in the current inventory.',
          404,
        );
      const source = discovery.getFileForMutation(resource.source.fileId);
      if (!source || source.entry.kind !== 'skill')
        throw error('SOURCE_NOT_FOUND', 'Skill source is not available.', 404);
      const directory = dirname(source.path);
      const files = await scanSkillDirectory(directory);
      noSecrets(files);
      const scripts = files.filter(scriptLike).map((entry) => entry.path);
      if (scripts.length && !request.confirmScripts)
        throw error(
          'SCRIPT_REVIEW_REQUIRED',
          'Skill contains executable or script-like files. Review the listed paths before exporting.',
          422,
          { scripts },
        );
      parseSkillName(files.find((entry) => entry.path === 'SKILL.md').data.toString('utf8'));
      const zip = createZip(
        files.map((entry) => ({
          ...entry,
          path: `${resource.name}/${entry.path}`,
          mode: entry.mode,
        })),
      );
      if (zip.length > MAX_ARCHIVE_BYTES)
        throw error('ARCHIVE_LIMIT', 'Skill archive exceeds the export size bound.', 413);
      return {
        filename: `${resource.name}.zip`,
        contentBase64: zip.toString('base64'),
        size: zip.length,
        files: files.map((entry) => ({
          path: entry.path,
          size: entry.data.length,
          executable: Boolean(entry.mode & 0o111),
        })),
        scripts,
        modePolicy:
          'Export preserves executable metadata; archive is downloaded only after confirmation. No files are uploaded.',
      };
    },
  };
}
