"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma = new client_1.PrismaClient();
async function main() {
    const password = await bcryptjs_1.default.hash("admin123", 10);
    const user = await prisma.user.create({
        data: { email: "admin@adstation.com", password, firstName: "Admin", lastName: "User", title: "Mr.", department: "IT", position: "System Admin", role: "admin" },
    });
    console.log(`✅ Admin user created: ${user.email}`);
}
main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=seed-user.js.map