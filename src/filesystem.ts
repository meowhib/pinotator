import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve an application-authorized target without allowing traversal or symlink escapes. */
export async function authorizePath(
  root: string,
  requested: string,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(canonicalRoot, requested);
  if (!inside(canonicalRoot, target)) throw new Error('PATH_OUTSIDE_ALLOWED_ROOT');
  let current = canonicalRoot;
  let targetExists = true;
  for (const part of relative(canonicalRoot, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED');
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      targetExists = false;
      break;
    }
  }
  if (targetExists) {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('NOT_A_REGULAR_FILE');
  } else {
    // Ensure the nearest existing ancestor is still within the canonical allowed root.
    let ancestor = dirname(target);
    for (;;) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        if (!inside(canonicalRoot, canonicalAncestor)) throw new Error('PATH_OUTSIDE_ALLOWED_ROOT');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
  return target;
}
