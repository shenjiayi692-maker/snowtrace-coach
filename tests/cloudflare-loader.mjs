export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    const source = `export const env = new Proxy({}, {
      get(_target, property) {
        return globalThis.__snowtraceCloudflareEnv?.[property];
      }
    });`;
    return {
      url: `data:text/javascript,${encodeURIComponent(source)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
