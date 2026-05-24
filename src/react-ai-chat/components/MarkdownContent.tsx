/* eslint-disable @typescript-eslint/no-explicit-any */
import { FunctionComponent, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkMath from "remark-math";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs as highlightStyle } from "react-syntax-highlighter/dist/esm/styles/prism";

interface MarkdownContentProps {
  content: string;
  doRehypeRaw?: boolean;
}

// Convert LaTeX-style math delimiters (\( \), \[ \]) into the dollar-sign
// delimiters that remark-math 6 actually parses. Only touches segments
// outside fenced code blocks, so code samples that contain these literal
// characters survive untouched.
const normalizeMathDelimiters = (input: string): string => {
  if (!input) return input;
  const segments = input.split(/(```[\s\S]*?```)/g);
  return segments
    .map((seg, i) => {
      // Odd indices are fenced code blocks (preserve verbatim).
      if (i % 2 === 1) return seg;
      // Block math: \[ ... \]  →  $$ ... $$
      let out = seg.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => {
        return `$$${body}$$`;
      });
      // Inline math: \( ... \)  →  $ ... $
      out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => {
        return `$${body}$`;
      });
      return out;
    })
    .join("");
};

const MarkdownContent: FunctionComponent<MarkdownContentProps> = ({
  content,
  doRehypeRaw,
}) => {
  const rehypePlugins = useMemo(() => {
    const plugins: any[] = [rehypeKatex];
    if (doRehypeRaw) {
      plugins.push(rehypeRaw);
    }
    return plugins;
  }, [doRehypeRaw]);

  const remarkPlugins = useMemo(() => {
    const plugins: any[] = [remarkGfm, remarkMath];
    return plugins;
  }, []);

  const renderedContent = useMemo(
    () => normalizeMathDelimiters(content),
    [content]
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        a({ children, ...props }) {
          return (
            <a
              href={props.href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          );
        },
        code(props) {
          const { children, className, ...rest } = props;
          const match = /language-(\w+)/.exec(className || "");
          const code = String(children).replace(/\n$/, "");

          // eslint-disable-next-line react-hooks/rules-of-hooks
          const [copied, setCopied] = useState(false);

          const handleCopy = () => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          };

          return match ? (
            <div style={{ position: "relative" }}>
              <SyntaxHighlighter
                PreTag="div"
                children={code}
                language={match[1]}
                style={highlightStyle}
              />
              <button
                onClick={handleCopy}
                style={{
                  color: "black",
                  position: "absolute",
                  right: "8px",
                  bottom: "24px",
                  padding: "4px 8px",
                  fontSize: "12px",
                  background: "#f5f5f5",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          ) : (
            <code
              {...rest}
              className={className}
              style={{
                background: "#eee",
                padding: "2px 4px",
                borderRadius: "3px",
              }}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {renderedContent}
    </ReactMarkdown>
  );
};

export default MarkdownContent;
