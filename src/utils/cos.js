const COS = require('cos-nodejs-sdk-v5');

// 初始化COS客户端
const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
  EnableMultiAZ: true
});

const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION;

/**
 * 上传文件到COS
 * @param {Buffer|string} fileContent - 文件内容
 * @param {string} key - 存储路径，如 'hairstyles/xxx.jpg'
 * @returns {Promise<string>} - 返回文件访问URL
 */
async function uploadFile(fileContent, key) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
      Body: fileContent,
      StorageClass: 'STANDARD'
    }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        // 返回CDN地址或COS默认地址
        const cdnDomain = process.env.COS_CDN_DOMAIN;
        const fileUrl = cdnDomain
          ? `https://${cdnDomain}/${key}`
          : `https://${BUCKET}.cos.${REGION}.tencentcos.cn/${key}`;
        resolve(fileUrl);
      }
    });
  });
}

/**
 * 上传Base64图片到COS
 * @param {string} base64Data - base64数据（格式：data:image/png;base64,xxxxx）
 * @param {string} key - 存储路径
 * @returns {Promise<string>} - 返回文件URL
 */
async function uploadBase64Image(base64Data, key) {
  // 解析base64
  const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error('无效的base64格式');
  }

  const mimeType = matches[1];
  const base64Str = matches[2];
  const buffer = Buffer.from(base64Str, 'base64');

  return uploadFile(buffer, key);
}

/**
 * 删除COS文件
 * @param {string} key - 存储路径
 */
async function deleteFile(key) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

module.exports = {
  uploadFile,
  uploadBase64Image,
  deleteFile
};