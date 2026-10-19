/** Verify Neon's TLS certificate and hostname, including after future driver upgrades. */
export function databaseConnectionString(value: string): string {
  const url = new URL(value);
  if (url.hostname.endsWith(".neon.tech")) {
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.delete("uselibpqcompat");
  }
  return url.toString();
}
