'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// Renders markdown with LaTeX math ($…$ and $$…$$) for previewing generated
// problems, whose statements are otherwise hard to read as raw source.
function PureMathMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed [&_p]:my-2 [&_.katex-display]:overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const MathMarkdown = memo(
  PureMathMarkdown,
  (prev, next) => prev.children === next.children,
);
