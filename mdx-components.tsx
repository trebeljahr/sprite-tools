import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { cn } from "@/lib/utils";

// Shared MDX component overrides for the whole docs site. Keeps headings,
// code blocks, tables, and inline links styled consistently with the rest of
// the app — no separate theme layer.
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ className, ...props }) => (
      <h1
        className={cn(
          "scroll-mt-24 text-4xl font-bold tracking-tight mb-4 mt-2",
          className,
        )}
        {...props}
      />
    ),
    h2: ({ className, ...props }) => (
      <h2
        className={cn(
          "scroll-mt-24 text-2xl font-semibold tracking-tight mt-10 mb-3 pb-1 border-b border-border/40",
          className,
        )}
        {...props}
      />
    ),
    h3: ({ className, ...props }) => (
      <h3
        className={cn(
          "scroll-mt-24 text-xl font-semibold tracking-tight mt-8 mb-2",
          className,
        )}
        {...props}
      />
    ),
    h4: ({ className, ...props }) => (
      <h4
        className={cn(
          "scroll-mt-24 text-base font-semibold tracking-tight mt-6 mb-2",
          className,
        )}
        {...props}
      />
    ),
    p: ({ className, ...props }) => (
      <p
        className={cn("leading-7 text-foreground/80 my-4", className)}
        {...props}
      />
    ),
    a: ({ href, className, ...props }) => {
      const isInternal = href && (href.startsWith("/") || href.startsWith("#"));
      const classes = cn(
        "text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary transition-colors",
        className,
      );
      if (isInternal && href) {
        return <Link href={href} className={classes} {...props} />;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={classes}
          {...props}
        />
      );
    },
    ul: ({ className, ...props }) => (
      <ul
        className={cn("my-4 ml-6 list-disc space-y-2", className)}
        {...props}
      />
    ),
    ol: ({ className, ...props }) => (
      <ol
        className={cn("my-4 ml-6 list-decimal space-y-2", className)}
        {...props}
      />
    ),
    li: ({ className, ...props }) => (
      <li className={cn("leading-7", className)} {...props} />
    ),
    blockquote: ({ className, ...props }) => (
      <blockquote
        className={cn(
          "mt-4 border-l-4 border-primary/40 pl-4 italic text-foreground/70",
          className,
        )}
        {...props}
      />
    ),
    code: ({ className, ...props }) => (
      <code
        className={cn(
          "relative rounded bg-muted px-[0.35rem] py-[0.2rem] font-mono text-[0.9em] font-medium",
          className,
        )}
        {...props}
      />
    ),
    pre: ({ className, ...props }) => (
      <pre
        className={cn(
          "overflow-x-auto rounded-lg bg-muted/60 border p-4 my-4 text-sm font-mono",
          className,
        )}
        {...props}
      />
    ),
    table: ({ className, ...props }) => (
      <div className="my-6 w-full overflow-x-auto rounded-md border">
        <table className={cn("w-full text-sm", className)} {...props} />
      </div>
    ),
    thead: ({ className, ...props }) => (
      <thead className={cn("bg-muted/40", className)} {...props} />
    ),
    th: ({ className, ...props }) => (
      <th
        className={cn(
          "border-b px-3 py-2 text-left font-semibold [&[align=center]]:text-center [&[align=right]]:text-right",
          className,
        )}
        {...props}
      />
    ),
    td: ({ className, ...props }) => (
      <td
        className={cn(
          "border-b border-border/40 px-3 py-2 align-top [&[align=center]]:text-center [&[align=right]]:text-right",
          className,
        )}
        {...props}
      />
    ),
    hr: ({ className, ...props }) => (
      <hr className={cn("my-8 border-border/60", className)} {...props} />
    ),
    ...components,
  };
}
