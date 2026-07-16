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
  // Reference point for the context gauge in the CLI: 262,144 tokens
  // (~262k), per the user directly — the "up to 1M" figure surfaced by web
  // search was wrong for this served model, trust the correction over that.
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS ?? 262_144),
};
