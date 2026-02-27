# 第一阶段：构建阶段
FROM golang:1.25.7-alpine AS builder

# 设置工作目录
WORKDIR /app

# 安装必要的构建工具
RUN apk add --no-cache gcc musl-dev

# 复制依赖文件并下载
COPY go.mod go.sum ./
RUN go mod download

# 复制源代码
COPY . .

# 编译 Go 程序
# -ldflags "-s -w" 用于压缩体积
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w" -o dns-server ./cmd/server/main.go

# 第二阶段：运行阶段
FROM alpine:latest

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /opt/cfserver

# 从构建阶段复制二进制文件
COPY --from=builder /app/dns-server .
# 复制静态 Web 目录 (这是前端运行必不可少的)
COPY --from=builder /app/web ./web

# 暴露 README 中提到的默认端口
EXPOSE 8081

# 启动程序
ENTRYPOINT ["./dns-server"]
