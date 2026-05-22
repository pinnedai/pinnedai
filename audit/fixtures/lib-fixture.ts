// Library fixture for the library-returns template audit.
// Provides one "healthy" export and one "broken" export so the audit
// can run both pos + neg controls against the same module path.

export function parseConfigHealthy(): { version: number } {
  return { version: 1 };
}

export function parseConfigBroken(): { version: number } {
  // Returns the WRONG version on purpose — negative control.
  return { version: 2 };
}

export function addHealthy(a: number, b: number): number {
  return a + b;
}

export function addBroken(a: number, b: number): number {
  // Off-by-one on purpose — negative control.
  return a + b + 1;
}
