import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

export function MarkdownBlock({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown className="markdown-body" remarkPlugins={REMARK_PLUGINS}>
      {markdown}
    </ReactMarkdown>
  );
}
