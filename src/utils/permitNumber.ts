import { prisma } from "../config/database";

function pad(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
}

export async function generateWithdrawalPermitNumber(): Promise<string> {
  const prefix = `W-${todayStr()}-`;
  const last = await prisma.withdrawalPermit.findFirst({
    where: { permitNumber: { startsWith: prefix } },
    orderBy: { permitNumber: "desc" },
  });
  const seq = last ? parseInt(last.permitNumber.slice(-3), 10) + 1 : 1;
  return `${prefix}${pad(seq, 3)}`;
}

export async function generateSupplyPermitNumber(): Promise<string> {
  const prefix = `S-${todayStr()}-`;
  const last = await prisma.supplyPermit.findFirst({
    where: { permitNumber: { startsWith: prefix } },
    orderBy: { permitNumber: "desc" },
  });
  const seq = last ? parseInt(last.permitNumber.slice(-3), 10) + 1 : 1;
  return `${prefix}${pad(seq, 3)}`;
}
