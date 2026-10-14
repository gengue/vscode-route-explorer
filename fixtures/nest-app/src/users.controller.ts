import { Controller, Get, Head, Options } from "@nestjs/common";

@Controller({ path: "users", version: "1" })
export class UsersController {
  @Get()
  findAll(): void {}

  @Get(":id")
  findOne(): void {}

  @Head(":id")
  headOne(): void {}

  @Options()
  options(): void {}
}
