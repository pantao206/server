/**
 * COS连接测试脚本
 * 运行方式: node test-cos.js
 */

require('dotenv').config();

const COS = require('cos-nodejs-sdk-v5');

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY
});

const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION;

console.log('=== COS配置检查 ===');
console.log('SecretId:', process.env.COS_SECRET_ID ? '已配置' : '未配置');
console.log('SecretKey:', process.env.COS_SECRET_KEY ? '已配置' : '未配置');
console.log('Bucket:', BUCKET);
console.log('Region:', REGION);
console.log('');

// 测试上传一个很小的PNG图片（1x1像素）
const testImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function testUpload() {
  console.log('=== 开始上传测试 ===');
  
  // 解析base64
  const matches = testImageBase64.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    console.error('Base64格式解析失败');
    return;
  }
  
  const buffer = Buffer.from(matches[2], 'base64');
  const key = `test/${Date.now()}_test.png`;
  
  console.log('上传到:', key);
  console.log('文件大小:', buffer.length, 'bytes');
  
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
      Body: buffer,
      StorageClass: 'STANDARD'
    }, (err, data) => {
      if (err) {
        console.error('上传失败!');
        console.error('错误代码:', err.statusCode);
        console.error('错误信息:', err.message);
        if (err.code) console.error('错误代码:', err.code);
        reject(err);
      } else {
        console.log('上传成功!');
        console.log('返回数据:', JSON.stringify(data, null, 2));
        const url = `https://${BUCKET}.cos.${REGION}.tencentcos.cn/${key}`;
        console.log('文件URL:', url);
        resolve(data);
      }
    });
  });
}

testUpload()
  .then(() => {
    console.log('\n=== 测试完成 ===');
    console.log('COS连接正常，可以上传文件');
  })
  .catch((err) => {
    console.log('\n=== 测试完成 ===');
    console.log('COS连接失败');
    console.log('\n可能的原因:');
    console.log('1. SecretId/SecretKey 错误或已过期');
    console.log('2. Bucket 不存在或名称错误');
    console.log('3. 该密钥没有上传到该Bucket的权限');
    console.log('4. Bucket的访问权限设置为"私有读写"但密钥没有对应权限');
    console.log('\n请到腾讯云控制台检查:');
    console.log('- 访问密钥是否有效');
    console.log('- Bucket是否存在且名称正确');
    console.log('- 密钥是否有上传权限');
  });