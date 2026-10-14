import { NestFactory } from "@nestjs/core";

class AppModule {}

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
}
