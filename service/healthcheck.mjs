try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '3000'}/readyz`, { signal: AbortSignal.timeout(2_000) });
  const data = await response.json();
  if (!response.ok || data.status !== 'ready') process.exitCode = 1;
} catch { process.exitCode = 1; }
