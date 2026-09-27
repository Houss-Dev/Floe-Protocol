import { MarketingFooter } from "../../components/MarketingFooter";
import { MarketingNav } from "../../components/MarketingNav";

export const viewport = { themeColor: "#1a1a1a" };

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <MarketingNav />
      <main className="pt-0 pb-0">{children}</main>
      <MarketingFooter />
    </>
  );
}
