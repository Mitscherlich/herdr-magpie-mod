// A remote trace is read on that machine's loopback, through Herdr's existing
// core connection. No tunnel, listening port, remote install or shell command.
export const TRACE_URL = "http://127.0.0.1:3425/v1/magpie/trace";

export async function readTrace(machine, seq, wait, io) {
  const url = `${TRACE_URL}?after=${seq}${wait ? "&wait=1" : ""}`;
  if (machine === null) {
    const response = await io.fetch(url);
    if (!response.ok) throw new Error(`Magpie HTTP ${response.status}`);
    return response.json();
  }
  const result = await io.exec("curl", [
    "--silent", "--show-error", "--fail", "--noproxy", "*",
    "--connect-timeout", "3", "--max-time", "28", url,
  ], { on: machine, timeout: 30000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Remote Magpie read failed (curl ${result.code})`);
  return JSON.parse(result.stdout);
}
