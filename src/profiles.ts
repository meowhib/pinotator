import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const saveSchema = z
  .object({
    fileId: z.string().uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/),
    confirmed: z.literal(true),
  })
  .strict();
const stageSchema = z
  .object({
    profileId: z.string().uuid(),
    fileId: z.string().uuid(),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();
const deleteSchema = z
  .object({ profileId: z.string().uuid(), confirmed: z.literal(true) })
  .strict();
const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,})\b|https?:\/\/[^/@\s]+:[^/@\s]+@[^\s]+/i;
function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function createProfileService(options: {
  presetService: ReturnType<typeof import('./presets.js').createPresetService>;
  stateDirectory?: string;
}) {
  const { presetService } = options;
  const root = resolve(
    options.stateDirectory ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pinotator'),
    'profiles',
  );
  let queue = Promise.resolve();
  async function ensureRoot() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    )
      throw fail(
        'PROFILE_STORE_UNSAFE',
        'Private profile storage is unavailable or has unsafe permissions.',
        403,
      );
  }
  async function readStored(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw fail('INVALID_PROFILE_ID', 'Profile ID is invalid.');
    await ensureRoot();
    const path = join(root, `${id}.json`);
    const info = await lstat(path).catch(() => null);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size > 1024 * 1024 ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw fail('PROFILE_NOT_FOUND', 'Profile was not found in private local storage.', 404);
    let profile;
    try {
      profile = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw fail('PROFILE_INVALID', 'Stored profile is invalid.', 422);
    }
    if (
      profile?.id !== id ||
      profile.schemaVersion !== 1 ||
      typeof profile.name !== 'string' ||
      !Array.isArray(profile.settings) ||
      profile.settings.length < 1 ||
      profile.settings.length > 40
    )
      throw fail('PROFILE_INVALID', 'Stored profile does not match the supported schema.', 422);
    return { profile, path };
  }
  async function listUnlocked() {
    await ensureRoot();
    const profiles = [];
    for (const name of await readdir(root)) {
      const match = /^([a-f0-9-]{36})\.json$/.exec(name);
      if (!match) continue;
      try {
        const { profile } = await readStored(match[1]);
        profiles.push({
          id: profile.id,
          name: profile.name,
          createdAt: profile.createdAt,
          settingCount: profile.settings.length,
        });
      } catch {}
    }
    return profiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }
  const serialize = (operation) => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  return {
    async list() {
      return serialize(listUnlocked);
    },
    async save(payload) {
      return serialize(async () => {
        const request = saveSchema.parse(payload);
        if (SECRET.test(request.name))
          throw fail(
            'SECRET_BEARING_CONTENT',
            'Profile name cannot contain credential-like text.',
            422,
          );
        const preset = await presetService.exportPreset({
          fileId: request.fileId,
          name: request.name,
          confirmed: true,
        });
        if (!preset.settings.length)
          throw fail(
            'EMPTY_PROFILE',
            'Selected settings file has no supported non-secret fields to save.',
            422,
          );
        const existing = await listUnlocked();
        if (existing.length >= 50)
          throw fail('PROFILE_LIMIT', 'Delete an unused profile before saving another.', 413);
        await ensureRoot();
        const id = randomUUID();
        const profile = {
          id,
          schemaVersion: 1,
          name: request.name,
          createdAt: new Date().toISOString(),
          settings: preset.settings,
        };
        const temp = join(root, `.${id}.tmp`);
        const destination = join(root, `${id}.json`);
        try {
          await writeFile(temp, JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
          await rename(temp, destination);
        } catch (error) {
          await unlink(temp).catch(() => {});
          throw error;
        }
        return {
          id,
          name: profile.name,
          createdAt: profile.createdAt,
          settingCount: profile.settings.length,
        };
      });
    },
    async stage(payload) {
      const request = stageSchema.parse(payload);
      const { profile } = await readStored(request.profileId);
      const preset = {
        schemaVersion: 1,
        name: profile.name,
        exportedAt: profile.createdAt,
        settings: profile.settings,
      };
      const bytes = Buffer.from(JSON.stringify(preset));
      return presetService.stagePreset({
        fileId: request.fileId,
        expectedHash: request.expectedHash,
        filename: `${profile.name}.json`,
        presetBase64: bytes.toString('base64'),
        confirmed: true,
      });
    },
    async delete(payload) {
      return serialize(async () => {
        const request = deleteSchema.parse(payload);
        const { path } = await readStored(request.profileId);
        await unlink(path);
        return { deleted: true };
      });
    },
  };
}
