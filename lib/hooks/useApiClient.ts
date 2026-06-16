'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';

export function useApiClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const apiClient = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);

    // Clone the response so we can read the JSON without consuming it for the actual caller
    const resClone = res.clone();
    
    try {
      const data = await resClone.json();
      
      // CASE 1: Logged in, no account
      if (data?.errorCode === 'AUTH_403_MODAL') {
        const params = new URLSearchParams(searchParams.toString());
        params.set('modal', 'true');
        router.push(`${pathname}?${params.toString()}`);
      }
      
      // CASE 2: Session expired entirely / Not logged in
      if (data?.errorCode === 'AUTH_401') {
        // 1. Grab their exact current URL and append the modal parameter
        const intendedUrl = new URL(window.location.href);
        intendedUrl.searchParams.set('modal', 'true');

        // 2. Determine the correct auth provider URL
        const mainSiteUrl = process.env.NODE_ENV === 'production' 
          ? 'https://competemath.com/auth/login'
          : 'http://localhost:3001/auth/login';
        
        const loginUrl = new URL(mainSiteUrl);
        
        // 3. Attach the callback and execute a hard browser redirect
        loginUrl.searchParams.set('callbackUrl', intendedUrl.toString());
        window.location.href = loginUrl.toString();
      }
    } catch (error) {
      // Not a JSON response, ignore safely
    }

    // Always return the original response so the calling function can handle UI loading states natively
    return res;
  };

  return apiClient;
}
