require('dotenv').config();//访问.env文件
const express = require('express');  //引入express框架 
const axios = require('axios');  //引入axios库     
const cors = require('cors'); //引入cors库
const app = express();  //创建express应用
const port = process.env.PORT || 3004; //设置端口号    
app.use(express.json());  //让express能够解析JSON请求体
app.use(cors()); //启用CORS

app.post('/v1/chat/completions', async (req, res) => { //定义POST接口
	try{
		const requestData = req.body; //获取请求体数据
		const systemMessage = { //定义系统提示词
			role: 'system',
			content: `you are an open source license compliance expert expertised in MIT license，please follow the folwing instructions when you recieved a code-ammending request:
			1. first,return the SCNOSS report of the user's code and the original code, and explain the report in a concise way.
			2. if the similarity between the user's code and the original code reaches up to 80%, inform the user to add the MIT license header to the code and provide the correct license header format.
			3. if there haven't match any original code, inform the user that there is no risk in violating the MIT license.`
		};
		requestData.messages.unshift(systemMessage); //将系统消息添加到消息列表开头
		const response = await axios({//使用axios发送HTTP请求
			method: 'post',//请求方法
			url: process.env.API_BASE_URL,//从 .env 读取实际的 API 地址
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${process.env.IPguard_API_key}` //使用环境变量中的API密钥
			},
			data: requestData,//拼好发送给API
		});
		res.json(response.data); //将API响应数据返回给客户端
	} catch (error) {
		console.error('Error:', error.message); //打印错误信息
		res.status(error.response?.status || 500).json({ error: 'An error occurred while processing the request.' }); //返回错误响应
	}
});
app.get('/health', (req, res) => { //定义健康检查接口
	res.send('normal'); //返回OK表示服务正常
});
app.listen(port, host, () => { //启动服务器
	console.log(`IPguard proxy listening on http://${host}:${port}`);
	console.log(`Health check: http://${host}:${port}/health`);
});
