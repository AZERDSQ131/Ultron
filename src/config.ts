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
};
