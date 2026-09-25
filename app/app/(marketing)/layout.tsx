import { MarketingFooter } from "../../components/MarketingFooter";
import { MarketingNav } from "../../components/MarketingNav";

export const viewport = { themeColor: "#ffffff" };

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-6xl px-4 pt-0 pb-24">{children}</main>
      <MarketingFooter />
    </>
  );
}
