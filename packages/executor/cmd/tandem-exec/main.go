// tandem-exec 是远端机器上的瘦执行器：只出站连接工作站，执行工作站下发的命令与文件操作。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"tandem/executor/internal/client"
	"tandem/executor/internal/identity"
	"tandem/executor/internal/ops"
	"tandem/executor/internal/service"
)

const usage = `用法：
  tandem-exec join --server <工作站地址> --token <令牌> [--service]   首次登记，然后前台保持连接
  tandem-exec run                                         按已登记的身份前台保持连接
  tandem-exec --version`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	switch args[0] {
	case "--version", "version":
		fmt.Printf("tandem-exec %s %s/%s\n", ops.Version, runtime.GOOS, runtime.GOARCH)
		return 0
	case "join":
		fl := flag.NewFlagSet("join", flag.ContinueOnError)
		server := fl.String("server", "", "工作站地址，如 http://192.168.1.10:8481")
		token := fl.String("token", "", "工作站生成的一次性令牌（ach_…，15 分钟内有效）")
		serviceFlag := fl.Bool("service", false, "设置开机自启（下次登录后自动连接）")
		if err := fl.Parse(args[1:]); err != nil {
			return 2
		}
		if *serviceFlag {
			if msg, err := service.Install(); err != nil {
				fmt.Fprintf(os.Stderr, "警告：设置开机自启失败：%v（本次仍会前台连接）\n", err)
			} else {
				fmt.Println(msg)
			}
		}
		return serve(*server, *token)
	case "run":
		return serve("", "")
	case "-h", "--help", "help":
		fmt.Println(usage)
		return 0
	}
	fmt.Fprintf(os.Stderr, "未知命令：%s\n\n%s\n", args[0], usage)
	return 2
}

func serve(server, token string) int {
	logger := log.New(os.Stderr, "", log.LstdFlags)
	home, err := identity.Home()
	if err != nil {
		logger.Printf("无法确定主目录：%v", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := client.New(home, logger).Serve(ctx, server, token); err != nil {
		logger.Printf("%v", err)
		return 1
	}
	return 0
}
