/** How a container user value reads. */
export type ContainerUserKind = 'root' | 'non_root'

/**
 * Reads a `user[:group]` value as Docker does: only the user part decides. `root` and any
 * all zero uid (`0`, `00`) are root, whatever the group, so `0:1000` is root and `1000:0` is not.
 * Empty means root too (the image config's empty user).
 */
export function classifyContainerUser(value: string): ContainerUserKind {
  const user = (value.split(':')[0] ?? '').trim()
  if (user === '' || user === 'root' || /^0+$/.test(user)) return 'root'
  return 'non_root'
}
