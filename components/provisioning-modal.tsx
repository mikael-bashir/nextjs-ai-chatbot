'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

interface ProvisioningModalProps {
  onSuccess: () => void;
}

export function ProvisioningModal({ onSuccess }: ProvisioningModalProps) {
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { update } = useSession();

  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const handleProvision = async () => {
    if (!acceptedTerms || isSubmitting) return;
    
    setIsSubmitting(true);

    try {
      // 1. TRIGGER YOUR BACKEND CREATION
      // If you have a Server Action: await createLeakAccountAction();
      // Otherwise, hit your API route:
      await fetch('/api/auth/provision', { method: 'POST' });

      // 2. UPDATE THE SESSION COOKIE IN THE BROWSER
      await update({ hasLeakAccount: true });

      // 3. DESTROY THE MODAL PARAM (Triggered via the parent listener)
      onSuccess();
    } catch (error) {
      console.error("Provisioning failed:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm sm:p-6">
      <div 
        className="w-full max-w-md overflow-hidden bg-white rounded-2xl shadow-2xl ring-1 ring-gray-200 animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Header Section */}
        <div className="px-6 pt-8 pb-6 text-center border-b border-gray-100 bg-gray-50/50">
          {/* <div className="inline-flex items-center justify-center w-12 h-12 mb-4 bg-blue-100 rounded-full">
            <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div> */}
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Welcome to Leak
          </h2>
          <p className="mt-2 text-sm text-gray-500">
            Let's finish setting up your Leak profile so you can start solving.
          </p>
        </div>

        {/* Fine Print & Checkbox Section */}
        <div className="p-6 bg-white">
          <div className="p-4 mb-6 text-xs text-gray-600 rounded-lg bg-gray-50">
            <p className="font-semibold text-gray-700 mb-1">Terms & Conditions</p>
            <p>
              By proceeding, you agree to our Terms of Service and Privacy Policy. You authorize Leak to link with your CompeteMath identity, and give us consent to the storage of your account data and chat history to provide this service. You should never share sensitive or personal information with the AI. Leak is provided "as is" without any warranties.
            </p>
          </div>

          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="flex items-center h-5 mt-0.5">
              <input
                type="checkbox"
                className="w-4 h-4 text-blue-600 transition-colors border-gray-300 rounded cursor-pointer focus:ring-blue-500"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
                disabled={isSubmitting}
              />
            </div>
            <span className="text-sm text-gray-700 select-none group-hover:text-gray-900 transition-colors">
              I have read and agree to the Terms & Conditions.
            </span>
          </label>
        </div>

        {/* Action Button Section */}
        <div className="px-6 bg-white">
          <button
            onClick={handleProvision}
            disabled={!acceptedTerms || isSubmitting}
            className={`w-full py-3 px-4 rounded-xl font-medium text-white transition-all duration-200 flex justify-center items-center gap-2
              ${!acceptedTerms 
                ? 'bg-gray-300 cursor-not-allowed' 
                : 'bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-200 active:scale-[0.98]'
              }
            `}
          >
            {isSubmitting ? (
              <>
                <svg className="w-5 h-5 animate-spin text-white/70" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Provisioning Account...
              </>
            ) : (
              'Complete Setup'
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            // Just scrub the URL! The Edge will handle the rest if they misbehave.
            const params = new URLSearchParams(searchParams.toString());
            router.push('/');
          }}
          className="w-full mb-4 text-sm text-[10pt] hover:underline text-gray-400 transition-colors duration-200 hover:text-gray-600"
        >
          I'll setup later
        </button>
        <div className="flex items-center justify-center gap-1 mt-3 mb-2">
          <span className="text-xs font-medium text-gray-500">Powered by</span>
          {/* <span className="text-xs font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-amber-500 to-yellow-600 drop-shadow-[0_0_8px_rgba(245,158,11,0.6)]">
            CompeteMath
          </span> */}
          <div className="flex flex-col">
            <p
              className="
                font-serif font-bold text-[10pt]
                bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-500
                bg-[length:200%_auto]
                bg-clip-text text-transparent
                drop-shadow-[0_0_8px_rgba(251,191,36,0.8)]
                animate-shimmer
              "
            >
              CompeteMath
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}