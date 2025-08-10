process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.MASTER_SECRET = process.env.MASTER_SECRET || 'test-master-secret';

test('app module loads', () => {
  const app = require('../app');
  expect(app).toBeTruthy();
});
