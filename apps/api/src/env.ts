function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

function optionalNumber(name: string): number | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const env = {
  port: Number(process.env.API_PORT ?? 3939),
  upstreamDb: required("ZERO_UPSTREAM_DB"),
  authSecret: required("AUTH_SECRET"),
  typesafeKey: process.env.TYPESAFE_API_KEY?.trim() || null,
  typesafeModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || undefined,
  githubToken: process.env.GITHUB_TOKEN?.trim() || null,
  priceInputPerMTok: optionalNumber("TYPESAFE_PRICE_INPUT_PER_MTOK"),
  priceOutputPerMTok: optionalNumber("TYPESAFE_PRICE_OUTPUT_PER_MTOK"),
};
