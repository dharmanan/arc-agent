'use strict';

const { resolveErrorHttpStatus, toValidHttpStatus } = require('../httpStatus');

describe('httpStatus helpers', () => {
  test('toValidHttpStatus accepts only integer 400-599 values', () => {
    expect(toValidHttpStatus(400)).toBe(400);
    expect(toValidHttpStatus('503')).toBe(503);
    expect(toValidHttpStatus(' 429 ')).toBe(429);

    expect(toValidHttpStatus('deferred')).toBeNull();
    expect(toValidHttpStatus(200)).toBeNull();
    expect(toValidHttpStatus(600)).toBeNull();
    expect(toValidHttpStatus(500.5)).toBeNull();
    expect(toValidHttpStatus('500.5')).toBeNull();
  });

  test('prefers numeric statusCode over string business status', () => {
    const error = {
      statusCode: 503,
      status: 'deferred',
    };

    expect(resolveErrorHttpStatus(error, 500)).toBe(503);
  });

  test('keeps explicit numeric status when valid', () => {
    expect(resolveErrorHttpStatus({ status: 400 }, 500)).toBe(400);
    expect(resolveErrorHttpStatus({ httpStatus: '422' }, 500)).toBe(422);
  });

  test('falls back to 500 for invalid status values', () => {
    expect(resolveErrorHttpStatus({ status: 'deferred' }, 500)).toBe(500);
    expect(resolveErrorHttpStatus({ statusCode: 'abc' }, 500)).toBe(500);
    expect(resolveErrorHttpStatus({}, 500)).toBe(500);
  });
});