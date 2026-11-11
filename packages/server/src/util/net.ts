/** 严格判断来源地址是否为回环（含 IPv4-mapped IPv6）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1';
}
