import { asyncHandler } from './asyncHandler.js';
import type { NextFunction, Request, Response } from 'express';

describe('asyncHandler', () => {
  it('forwards a rejected promise to next(err)', async () => {
    const handler = asyncHandler(async (_req: Request, _res: Response) => {
      throw new Error('boom');
    });
    const next = jest.fn();

    await handler({} as Request, {} as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0] as [unknown])[0]).toBeInstanceOf(Error);
  });

  it('does not call next when the handler resolves', async () => {
    const handler = asyncHandler(async (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });
    const next = jest.fn();
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;

    await handler({} as Request, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
  });
});
