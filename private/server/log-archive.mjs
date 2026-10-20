/* SPDX-License-Identifier: MPL-2.0 */
import { crc32, deflateRawSync } from 'node:zlib';

// A bounded in-memory ZIP avoids temporary files on the read-only gateway.
export function logZip(files, date = new Date()) {
    const parts = [],
        directory = [];
    let offset = 0;
    const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
    const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    for (const [name, text] of Object.entries(files)) {
        if (!/^[a-z0-9-]+\.(log|json)$/.test(name)) throw new Error('Ungültiger ZIP-Dateiname.');
        const filename = Buffer.from(name),
            data = Buffer.from(text),
            compressed = deflateRawSync(data);
        if (data.length > 4 * 1024 * 1024) throw new Error('Protokolldatei ist zu groß.');
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x800, 6);
        header.writeUInt16LE(8, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(day, 12);
        header.writeUInt32LE(crc32(data), 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(filename.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50);
        central.writeUInt16LE(20, 4);
        header.copy(central, 6, 4, 30);
        central.writeUInt32LE(offset, 42);
        parts.push(header, filename, compressed);
        directory.push(central, filename);
        offset += header.length + filename.length + compressed.length;
    }
    const index = Buffer.concat(directory),
        end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(directory.length / 2, 8);
    end.writeUInt16LE(directory.length / 2, 10);
    end.writeUInt32LE(index.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, index, end]);
}
