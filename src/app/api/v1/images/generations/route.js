import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
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

/** POST /v1/images/generations - OpenAI-compatible image generation endpoint */
export const POST = withTenantContext(async function POST(request) {
  return await handleImageGeneration(request);
});
