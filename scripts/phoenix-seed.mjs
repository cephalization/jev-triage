// Seeds Phoenix's model price table with jev, so Phoenix's cost totals include TypeSafe calls.
// Phoenix has no boot-time seeding; prices live in its database and are created through the
// same GraphQL mutation its settings page uses. Runs from dev.mjs after compose is up, and can
// run alone: `node scripts/phoenix-seed.mjs` with PHOENIX_COLLECTOR_ENDPOINT and the two
// TYPESAFE_PRICE_*_PER_MTOK variables in the environment. Skips when a typesafe model exists.

const PROVIDER = "typesafe";
const NAME_PATTERN = "^jev";

async function gql(endpoint, query, variables = {}) {
  const res = await fetch(`${endpoint}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (!res.ok || body.errors?.length)
    throw new Error(body.errors?.map((e) => e.message).join("; ") ?? `status ${res.status}`);
  return body.data;
}

async function hasTypesafeModel(endpoint) {
  let after = null;
  for (;;) {
    const data = await gql(
      endpoint,
      `query ($after: String) { generativeModels(first: 200, after: $after) {
        edges { node { provider namePattern } } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    const page = data.generativeModels;
    if (page.edges.some((e) => e.node.provider === PROVIDER)) return true;
    if (!page.pageInfo.hasNextPage) return false;
    after = page.pageInfo.endCursor;
  }
}

/** Returns what happened, for the caller's log line. */
export async function seedPhoenixModel(env) {
  const endpoint = env.PHOENIX_COLLECTOR_ENDPOINT?.replace(/\/+$/, "");
  const input = Number(env.TYPESAFE_PRICE_INPUT_PER_MTOK);
  const output = Number(env.TYPESAFE_PRICE_OUTPUT_PER_MTOK);
  if (!endpoint) return "no Phoenix endpoint";
  if (!Number.isFinite(input) || !Number.isFinite(output))
    return "TYPESAFE_PRICE_INPUT_PER_MTOK and TYPESAFE_PRICE_OUTPUT_PER_MTOK are not both set";
  if (await hasTypesafeModel(endpoint)) return "jev already priced";
  await gql(
    endpoint,
    `mutation ($input: CreateModelMutationInput!) { createModel(input: $input) { model { id } } }`,
    {
      input: {
        name: "jev",
        provider: PROVIDER,
        namePattern: NAME_PATTERN,
        startTime: null,
        costs: [
          { tokenType: "input", kind: "PROMPT", costPerMillionTokens: input },
          { tokenType: "output", kind: "COMPLETION", costPerMillionTokens: output },
        ],
      },
    },
  );
  return `priced jev at $${input}/M in, $${output}/M out`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href)
  console.log(`[phoenix] ${await seedPhoenixModel(process.env)}`);
