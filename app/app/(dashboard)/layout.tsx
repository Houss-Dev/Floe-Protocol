import { DashboardShell } from "../../components/DashboardShell";

export const viewport = { themeColor: "#0c0b10" };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
