import Link from "next/link";

import { FloeBrandIcon } from "../../../components/FloeBrandIcon";
import {
  FloeLogoBracket,
  FloeLogoSplit,
  FloeLogoWordmark,
} from "../../../components/FloeLogoConcepts";

function ConceptCard({
  id,
  title,
  blurb,
  onDark,
  onCream,
  navDark,
  navCream,
}: {
  id: string;
  title: string;
  blurb: string;
  onDark: React.ReactNode;
  onCream: React.ReactNode;
  navDark: React.ReactNode;
  navCream: React.ReactNode;
}) {
  return (
    <article id={id} className="overflow-hidden rounded-2xl border border-[#f4f0e5]/15 bg-[#1a1a1a]">
      <div className="border-b border-[#f4f0e5]/10 px-6 py-5">
        <h2 className="font-condensed text-3xl uppercase tracking-tight text-[#f4f0e5]">{title}</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[#f4f0e5]/55">{blurb}</p>
      </div>
      <div className="grid gap-0 md:grid-cols-2">
        <div className="flex flex-col gap-8 border-[#f4f0e5]/10 p-8 md:border-r">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#f4f0e5]/40">On hero black</p>
          <div className="flex min-h-[120px] flex-wrap items-center gap-8">{onDark}</div>
          <div className="rounded-xl border border-[#f4f0e5]/10 bg-[#121212] px-4 py-3">
            <NavMock dark>{navDark}</NavMock>
          </div>
        </div>
        <div className="flex flex-col gap-8 bg-[#f4f0e5] p-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#17110b]/45">On cream</p>
          <div className="flex min-h-[120px] flex-wrap items-center gap-8">{onCream}</div>
          <div className="rounded-xl border border-[#17110b]/10 bg-white px-4 py-3">
            <NavMock dark={false}>{navCream}</NavMock>
          </div>
        </div>
      </div>
    </article>
  );
}

function NavMock({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`flex h-14 items-center justify-between gap-4 ${dark ? "text-[#f4f0e5]" : "text-[#17110b]"}`}
    >
      <div className="flex items-center gap-3">{children}</div>
      <span className={`text-xs font-semibold ${dark ? "text-[#f4f0e5]/50" : "text-[#17110b]/45"}`}>
        Nav preview
      </span>
    </div>
  );
}

export default function LogoLabPage() {
  return (
    <div className="min-h-screen bg-[#0b0b0f] pb-20 pt-8">
      <div className="ll-page">
        <Link href="/" className="text-sm font-semibold text-hot hover:underline">
          ← Back to landing
        </Link>
        <h1 className="mt-6 font-condensed text-5xl uppercase leading-[0.85] tracking-tight text-[#f4f0e5] md:text-7xl">
          Logo concepts
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[#f4f0e5]/60">
          Directions 1, 4, and 6 — compared to your current hex + PNG mark. Pick one (or mix) and
          we&apos;ll swap it across nav, dashboard, and favicon.
        </p>

        <div className="mt-10 space-y-10">
          <ConceptCard
            id="current"
            title="[ FLOE ] — chosen"
            blurb="FLOE framed by brackets — collateral held, credit drawn inside."
            onDark={
              <>
                <FloeBrandIcon size={72} ink="cream" />
                <FloeBrandIcon size={52} ink="cream" />
                <FloeBrandIcon size={34} ink="cream" compact />
              </>
            }
            onCream={
              <>
                <FloeBrandIcon size={72} ink="black" />
                <FloeBrandIcon size={52} ink="black" />
                <FloeBrandIcon size={34} ink="black" compact />
              </>
            }
            navDark={
              <>
                <FloeBrandIcon size={52} ink="cream" />
              </>
            }
            navCream={
              <>
                <FloeBrandIcon size={52} ink="black" />
              </>
            }
          />

          <ConceptCard
            id="wordmark"
            title="1 — Wordmark"
            blurb="Type-only lockup with orange ↗; compact F monogram for favicon-sized slots."
            onDark={
              <>
                <FloeLogoWordmark size={56} />
                <FloeLogoWordmark compact size={96} />
                <FloeLogoWordmark compact size={48} />
                <FloeLogoWordmark compact size={32} />
              </>
            }
            onCream={
              <>
                <FloeLogoWordmark size={48} ink="black" />
                <FloeLogoWordmark compact size={96} ink="black" />
                <FloeLogoWordmark compact size={48} ink="black" />
              </>
            }
            navDark={
              <>
                <FloeLogoWordmark size={40} />
              </>
            }
            navCream={
              <>
                <FloeLogoWordmark size={40} ink="black" />
              </>
            }
          />

          <ConceptCard
            id="bracket"
            title="4 — Bracket collateral"
            blurb="Bars held inside brackets; orange gap = drawable credit without selling."
            onDark={
              <>
                <FloeLogoBracket size={96} />
                <FloeLogoBracket size={48} />
                <FloeLogoBracket size={32} />
              </>
            }
            onCream={
              <>
                <FloeLogoBracket size={96} ink="black" />
                <FloeLogoBracket size={48} ink="black" />
              </>
            }
            navDark={
              <>
                <FloeLogoBracket size={48} />
                <span className="text-lg font-semibold">Floe</span>
              </>
            }
            navCream={
              <>
                <FloeLogoBracket size={48} ink="black" />
                <span className="text-lg font-semibold">Floe</span>
              </>
            }
          />

          <ConceptCard
            id="split"
            title="6 — Split mark"
            blurb="Stock bars on the left, stablecoin on the right, orange bridge between."
            onDark={
              <>
                <FloeLogoSplit size={96} />
                <FloeLogoSplit size={48} />
                <FloeLogoSplit size={32} />
              </>
            }
            onCream={
              <>
                <FloeLogoSplit size={96} ink="black" />
                <FloeLogoSplit size={48} ink="black" />
              </>
            }
            navDark={
              <>
                <FloeLogoSplit size={48} />
                <span className="text-lg font-semibold">Floe</span>
              </>
            }
            navCream={
              <>
                <FloeLogoSplit size={48} ink="black" />
                <span className="text-lg font-semibold">Floe</span>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
