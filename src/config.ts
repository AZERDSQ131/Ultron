import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const config = {
  nvidiaApiKey: required("NVIDIA_API_KEY"),
  nemotronModel: process.env.NEMOTRON_MODEL ?? "nvidia/nemotron-3-super-120b-a12b",
  nemotronBaseUrl: process.env.NEMOTRON_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://localhost:5432/ultron",
  // Approximate reference point for the context gauge in the CLI — not a
  // confirmed hard limit for this exact model (NVIDIA doesn't publish one
  // we've found), just a reasonable order-of-magnitude default.
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS ?? 128_000),
};
