import { handleTts } from "@/sse/handlers/tts.js";
import { withTenantContext } from "@/lib/tenant-context.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/audio/speech - OpenAI-compatible TTS endpoint */
export const POST = withTenantContext(async function POST(request) {
  return await handleTts(request);
});
