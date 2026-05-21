import ast
import json
import sys

SKIP_FIELDS = frozenset({
    'lineno', 'col_offset', 'end_lineno', 'end_col_offset',
    'type_comment',
})#剔除位置信息和注释

LITERAL_TYPES = frozenset({
    'Constant', 'Num', 'Str', 'Bytes', 'NameConstant', 'Ellipsis',
})#统一字面量类型为 Literal，并提取可比较的值

EMPTY_STMT_TYPES = frozenset({'Pass'})#剔除空语句

def ast_to_dict(node):
    if isinstance(node, ast.AST):
        result = {'type': type(node).__name__}
        for field in node._fields:
            # ExceptHandler.type 是异常类型表达式，不能覆盖节点名 type
            key = 'exc_type' if field == 'type' and isinstance(node, ast.ExceptHandler) else field
            result[key] = ast_to_dict(getattr(node, field))
        return result#将AST节点转换为字典
    if isinstance(node, list):
        return [ast_to_dict(item) for item in node]#递归处理列表中的每个元素
    return node#其他类型直接返回原值


def _literal_value(node):
    t = node.get('type')
    if t == 'Constant':
        return node.get('value')
    if t == 'Num':
        return node.get('n')
    if t in ('Str', 'Bytes'):
        return node.get('s')
    if t == 'NameConstant':
        return node.get('value')
    if t == 'Ellipsis':
        return ...
    return None#从不同版本的AST节点中提取字面量值


def _json_safe(value):
    if value is ...:
        return 'Ellipsis'
    if isinstance(value, (bytes, bytearray)):
        return value.decode('utf-8', errors='replace')
    if isinstance(value, complex):
        return {'real': value.real, 'imag': value.imag}
    return value#特殊类型转化为JSON


def _dict_sort_key(key_node):
    if key_node is None:
        return '\uffff'
    if isinstance(key_node, dict) and key_node.get('type') == 'Literal':
        return str(key_node.get('value', ''))
    return json.dumps(key_node, sort_keys=True, default=str)


def _keyword_sort_key(kw):
    """为 Call 的 keyword 参数生成排序键。"""
    arg = kw.get('arg')
    return arg if arg is not None else '\uffff'


def normalize_ast(node):
    if isinstance(node, list):
        return [
            item for item in
            (normalize_ast(child) for child in node)
            if item is not None
        ]
    if node is None or not isinstance(node, dict):
        return node

    node_type = node.get('type')
    if node_type in EMPTY_STMT_TYPES:
        return None

    cleaned = {}
    for key, value in node.items():
        if key in SKIP_FIELDS:
            continue
        cleaned[key] = normalize_ast(value)

    if cleaned.get('type') in LITERAL_TYPES:
        return {
            'type': 'Literal',
            'value': _json_safe(_literal_value(cleaned)),
        }

    if cleaned.get('type') == 'Dict':
        keys = cleaned.get('keys') or []
        values = cleaned.get('values') or []
        pairs = sorted(
            enumerate(zip(keys, values)),
            key=lambda item: _dict_sort_key(item[1][0]),
        )
        pairs = [p for _, p in pairs]
        if pairs:
            cleaned['keys'], cleaned['values'] = map(list, zip(*pairs))
        else:
            cleaned['keys'], cleaned['values'] = [], []

    if cleaned.get('type') == 'Call' and isinstance(cleaned.get('keywords'), list):
        cleaned['keywords'] = sorted(
            cleaned['keywords'],
            key=_keyword_sort_key,
        )

    if cleaned.get('type') in ('Import', 'ImportFrom') and isinstance(cleaned.get('names'), list):
        cleaned['names'] = sorted(
            cleaned['names'],
            key=lambda alias: alias.get('name', '') if isinstance(alias, dict) else '',
        )

    return cleaned#递归规范化处理


def main():
    code = sys.stdin.read()
    try:
        tree = ast.parse(code)#解析输入的Python代码为AST
        raw_ast = ast_to_dict(tree)#将AST转换为字典形式
        normalized = normalize_ast(raw_ast)
        print(
            json.dumps({'success': True, 'ast': normalized}, ensure_ascii=False),
            flush=True,
        )#输出规范化后的AST作为JSON
    except SyntaxError as e:
        print(json.dumps({'success': False, 'error': str(e)}), flush=True)
        sys.exit(0)
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}), flush=True)
        sys.exit(0)


if __name__ == '__main__':
    main()
