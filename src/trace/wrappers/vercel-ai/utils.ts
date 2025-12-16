/**
 * Vercel AI SDK wrapper utilities.
 * 
 * Minimal helpers - most logic is in the microservice.
 */

export function aiSdkDebug(label: string, data: unknown): void {
  console.log(`\n🔍 [Fallom Debug] ${label}:`, JSON.stringify(data, null, 2));
}
