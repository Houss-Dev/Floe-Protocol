import { DashboardShell } from "../../components/DashboardShell";

export const viewport = { themeColor: "#0a0a0c" };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
