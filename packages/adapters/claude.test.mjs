import test from 'node:test';
import assert from 'node:assert/strict';
import { claude } from './claude.js';

const withFiles = (files) => claude.files({ files });
const withAtts = (attachments) => claude.attachments({ attachments });

test('an uploaded document brings its text with it', () => {
  const [b] = withAtts([{
    id: 'a1', file_name: 'notes.txt', file_type: 'txt', file_size: 18862,
    extracted_content: 'the whole document',
  }]);
  assert.equal(b.type, 'file');
  assert.equal(b.text, 'the whole document');
  assert.equal(b.filename, 'notes.txt');
  assert.equal(b.mime, 'txt');
  assert.equal(b.meta.declaredBytes, 18862, 'kept so truncation can be detected later');
});

test('an attachment with no extracted text has no text key at all', () => {
  const [b] = withAtts([{ id: 'a2', file_name: 'scan.pdf', file_size: 10 }]);
  assert.equal('text' in b, false, 'an absent key beats an empty string in search');
  assert.equal(b.filename, 'scan.pdf');
});

test('an empty extraction is treated as no extraction', () => {
  const [b] = withAtts([{ id: 'a3', file_name: 'x', extracted_content: '' }]);
  assert.equal('text' in b, false);
});

test('a message with no attachments yields nothing', () => {
  assert.deepEqual(claude.attachments({}), []);
  assert.deepEqual(claude.attachments({ attachments: [] }), []);
});

test('files and attachments are separate lists, and both survive', () => {
  const msg = {
    files: [{ file_kind: 'image', file_name: 'a.png', file_uuid: 'f1', preview_url: '/p' }],
    attachments: [{ id: 'a1', file_name: 'b.txt', extracted_content: 'text' }],
  };
  const blocks = [...claude.files(msg), ...claude.attachments(msg)];
  assert.deepEqual(blocks.map((b) => b.type), ['image', 'file']);
  assert.equal(blocks[1].text, 'text');
});

test('an image points at the full-size preview, keeping the thumbnail aside', () => {
  const [b] = withFiles([{
    file_kind: 'image', file_name: 'shot.png', file_uuid: 'f1',
    preview_url: '/api/o/files/f1/preview', thumbnail_url: '/api/o/files/f1/thumbnail',
    preview_asset: { image_width: 1456, image_height: 817 },
  }]);
  assert.equal(b.srcRef, '/api/o/files/f1/preview', 'preview_url is full resolution, not a downscale');
  assert.equal(b.meta.thumbRef, '/api/o/files/f1/thumbnail');
  assert.deepEqual([b.width, b.height], [1456, 817]);
});

test('a non-image file still becomes a file block, not an image', () => {
  const [b] = withFiles([{ file_kind: 'document', file_name: 'x.pdf', file_uuid: 'f2' }]);
  assert.equal(b.type, 'file');
  assert.equal(b.srcRef, null, 'no url given, and none invented');
});
