import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response> | Response;
  };
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const transformImage = env.IMAGES
        ? async (
            body: ReadableStream,
            options: { width: number; format: string; quality: number },
          ) => {
            const result = await env.IMAGES!
              .input(body)
              .transform(options.width > 0 ? { width: options.width } : {})
              .output({ format: options.format, quality: options.quality });
            return result.response();
          }
        : undefined;

      return handleImageOptimization(
        request,
        {
          fetchAsset: async (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage,
        },
        allowedWidths,
      );
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
