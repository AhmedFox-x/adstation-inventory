"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateWithdrawalPermitNumber = generateWithdrawalPermitNumber;
exports.generateSupplyPermitNumber = generateSupplyPermitNumber;
const database_1 = require("../config/database");
function pad(n, len) {
    return String(n).padStart(len, "0");
}
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
}
async function generateWithdrawalPermitNumber() {
    const prefix = `W-${todayStr()}-`;
    const last = await database_1.prisma.withdrawalPermit.findFirst({
        where: { permitNumber: { startsWith: prefix } },
        orderBy: { permitNumber: "desc" },
    });
    const seq = last ? parseInt(last.permitNumber.slice(-3), 10) + 1 : 1;
    return `${prefix}${pad(seq, 3)}`;
}
async function generateSupplyPermitNumber() {
    const prefix = `S-${todayStr()}-`;
    const last = await database_1.prisma.supplyPermit.findFirst({
        where: { permitNumber: { startsWith: prefix } },
        orderBy: { permitNumber: "desc" },
    });
    const seq = last ? parseInt(last.permitNumber.slice(-3), 10) + 1 : 1;
    return `${prefix}${pad(seq, 3)}`;
}
//# sourceMappingURL=permitNumber.js.map