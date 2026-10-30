cmake_minimum_required(VERSION 3.21)
project(agentos-desktop LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(AGENTOS_FIXTURES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../fixtures" CACHE PATH "repository fixtures/ directory")
get_filename_component(AGENTOS_FIXTURES_ABS "${AGENTOS_FIXTURES_DIR}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")

# No WebEngine/WebView anywhere (spec §10, V1-D01): only these Qt modules are allowed.
find_package(Qt6 6.5 REQUIRED COMPONENTS Core Gui Network Qml Quick QuickControls2 Test)
find_package(Qt6 QUIET COMPONENTS WaylandClient)
qt_standard_project_setup(REQUIRES 6.5)

enable_testing()

# --- protocol primitives already shared with Rust/TS vectors
add_library(agentos_transport_min STATIC transport/native_rpc.cpp)
target_include_directories(agentos_transport_min PUBLIC transport)
add_executable(v1_vectors tests/v1_vectors.cpp)
target_link_libraries(v1_vectors PRIVATE agentos_transport_min)
add_test(NAME v1_vectors COMMAND v1_vectors ${AGENTOS_FIXTURES_ABS}/v1.0/protocol/vectors.json)

# --- renderer/transport core (Qt Core only; no GUI)
add_library(agentos_core STATIC
  transport/jvalue.cpp transport/jvalue.hpp
  renderer/json_schema.cpp renderer/json_schema.hpp
  renderer/slot_validator.cpp renderer/slot_validator.hpp
  renderer/slot_runtime.cpp renderer/slot_runtime.hpp
  renderer/records_view.cpp renderer/records_view.hpp
  renderer/routes.cpp renderer/routes.hpp
  renderer/error_policy.cpp renderer/error_policy.hpp
  renderer/shell_actions.cpp renderer/shell_actions.hpp
  transport/frame_codec.cpp transport/frame_codec.hpp
  transport/rpc_client.cpp transport/rpc_client.hpp)
target_include_directories(agentos_core PUBLIC transport renderer)
target_link_libraries(agentos_core PUBLIC Qt6::Core Qt6::Network)
qt_add_resources(agentos_core "core_data" PREFIX "/agentos/renderer" BASE renderer
  FILES renderer/slot-schemas.json renderer/error-policy.json renderer/routes.json)

add_executable(slot_vectors tests/slot_vectors.cpp)
target_link_libraries(slot_vectors PRIVATE agentos_core Qt6::Test)
target_compile_definitions(slot_vectors PRIVATE AGENTOS_FIXTURES="${AGENTOS_FIXTURES_ABS}")
add_test(NAME slot_vectors COMMAND slot_vectors)

foreach(t transport_test events_test)
  add_executable(${t} tests/${t}.cpp tests/fake_gateway.hpp)
  target_include_directories(${t} PRIVATE tests)
  target_link_libraries(${t} PRIVATE agentos_core Qt6::Test)
  add_test(NAME ${t} COMMAND ${t})
endforeach()

include(${CMAKE_CURRENT_SOURCE_DIR}/shell.cmake OPTIONAL)
