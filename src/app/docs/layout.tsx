"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_SECTIONS, flattenDocs } from "./_nav";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const flat = flattenDocs();
  const idx = flat.findIndex((i) => i.href === pathname);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

  return (
    <div className="container max-w-6xl mx-auto px-4 py-8">
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-8">
        <aside className="md:sticky md:top-16 md:self-start md:max-h-[calc(100vh-5rem)] md:overflow-y-auto">
          <nav className="text-sm space-y-6 pr-2">
            {DOCS_SECTIONS.map((section) => (
              <div key={section.label}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold mb-2 pl-2">
                  {section.label}
                </div>
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = pathname === item.href;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "block rounded px-2 py-1 transition-colors",
                            active
                              ? "bg-accent text-foreground font-medium"
                              : "text-foreground/70 hover:text-foreground hover:bg-accent/40",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <article className="prose-neutral max-w-none">{children}</article>

          {(prev || next) && (
            <div className="mt-16 pt-6 border-t border-border/40 grid grid-cols-2 gap-4 text-sm">
              <div>
                {prev && (
                  <Link
                    href={prev.href}
                    className="block rounded-md border p-3 hover:bg-accent/40 transition-colors"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      ← Previous
                    </div>
                    <div className="font-medium mt-1">{prev.label}</div>
                  </Link>
                )}
              </div>
              <div>
                {next && (
                  <Link
                    href={next.href}
                    className="block rounded-md border p-3 hover:bg-accent/40 transition-colors text-right"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 justify-end">
                      Next <ChevronRight className="w-3 h-3" />
                    </div>
                    <div className="font-medium mt-1">{next.label}</div>
                  </Link>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
