const needsExtension = (specifier) => (
  (specifier.startsWith('./') || specifier.startsWith('../'))
  && !specifier.endsWith('.js')
  && !specifier.endsWith('.mjs')
  && !specifier.endsWith('.json')
  && !specifier.endsWith('.css')
);

export async function resolve(specifier, context, nextResolve) {
  if (!needsExtension(specifier)) return nextResolve(specifier, context);
  try {
    return await nextResolve(`${specifier}.js`, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return nextResolve(specifier, context);
  }
}
