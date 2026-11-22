import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { setNonce } from 'get-nonce';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './app/router';
import { queryClient } from './lib/queryClient';
import { applyDensity, readDensity } from './lib/settings';
import { applyTheme, readThemePref } from './lib/theme';
import { cspNonce } from './ui/nonce';
import { Loading } from './ui/States';
import './styles/base.css';

// Radix (react-remove-scroll) injects <style> tags; under the production CSP they need the per-load nonce.
setNonce(cspNonce());
applyTheme(readThemePref());
applyDensity(readDensity());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<Loading what="Loading" />}>
        <RouterProvider router={router} />
      </Suspense>
    </QueryClientProvider>
  </StrictMode>,
);
