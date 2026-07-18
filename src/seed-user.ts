import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash("admin123", 10);
  const user = await prisma.user.create({
    data: { email: "admin@adstation.com", password, firstName: "Admin", lastName: "User", title: "Mr.", department: "IT", position: "System Admin", role: "admin" },
  });
  console.log(`✅ Admin user created: ${user.email}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
