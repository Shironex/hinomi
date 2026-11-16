module example.dev/kestrel/edge

go 1.24

require (
	example.dev/heron/codec v1.4.0
	example.dev/plover/sig v0.9.1
	example.dev/wren/net v0.3.1 // indirect
)

replace example.dev/plover/sig => ./third_party/sig
