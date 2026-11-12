import { corsHeaders } from './cors.ts';

export function errorResponse(
  message: string,
  status = 400,
  code = 'BAD_REQUEST',
  details?: unknown
): Response {
  const body: Record<string, unknown> = { error: { message, code } };
  if (details !== undefined) {
    (body.error as Record<string, unknown>).details = details;
  }
  return new Response(
    JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}

export function successResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}