import { Controller, Delete, Get, Patch, Post, Put } from "@nestjs/common";

@Controller("items")
export class ItemsController {
  /** List every item. */
  @Get()
  findAll(): void {}

  @Get(":id")
  findOne(): void {}

  @Post()
  create(): void {}

  @Put(":id")
  update(): void {}

  @Patch(":id")
  patch(): void {}

  @Delete(":id")
  remove(): void {}

  @Get(["archived", "old"])
  findArchived(): void {}
}
