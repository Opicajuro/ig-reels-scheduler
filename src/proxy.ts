import { NextResponse, type NextRequest } from "next/server";

// Localirs has no sign-in, so it only answers requests addressed to this PC. A web page can point its own domain at
// 127.0.0.1 (DNS rebinding) and reach the app through the browser; its requests then carry that domain as Host,
// and are refused here.
export const ALLOWED_HOSTS = ["localhost:3000", "127.0.0.1:3000"];

export function proxy(request: NextRequest) {
  if (!ALLOWED_HOSTS.includes(request.headers.get("host") ?? "")) {
    return new NextResponse("Localirs only answers on this PC.", { status: 403 });
  }
  return NextResponse.next();
}
