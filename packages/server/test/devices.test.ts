import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdbDevices } from '../src/devices/adb.js';
import { MockSerialTransport } from '../src/devices/serial.js';

test('adb devices -l：解析序列号、状态与 model/product', () => {
  const list = parseAdbDevices(`List of devices attached
R58M1234               device product:dreamlte model:SM_G950F device:dreamlte transport_id:1
EMU_B555               offline product:x model:Pixel_8 device:x transport_id:2
`);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    serial: 'R58M1234',
    state: 'device',
    model: 'SM_G950F',
    product: 'dreamlte',
    device: 'dreamlte',
    transportId: '1',
  });
  assert.equal(list[1].state, 'offline');
});

test('虚拟串口：列端口、启动日志、echo 与 reset', async () => {
  const transport = new MockSerialTransport();
  const ports = await transport.list();
  assert.equal(ports[0]?.path, 'mock://ttyUSB0');

  const conn = await transport.open('mock://ttyUSB0', 115200);
  const chunks: string[] = [];
  const off = conn.onData((text) => chunks.push(text));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(chunks.join('').includes('Tandem virtual serial ready'));

  chunks.length = 0;
  await conn.write('hello\n');
  assert.ok(chunks.join('').includes('[echo] hello'));

  chunks.length = 0;
  await conn.write('reset\n');
  const text = chunks.join('');
  assert.ok(text.includes('[board] reset requested'));
  assert.ok(text.includes('firmware 1.0.0'));

  off();
  await conn.close();
});
